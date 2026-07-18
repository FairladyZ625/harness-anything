import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isCloseoutPlaceholderMarkdown, isTaskDocumentPlaceholderMarkdown, parseReviewMarkdown, type TaskDocumentPlaceholderPolicy } from "../../../application/src/index.ts";
import { checkTaskProjection, extractMarkdownSection, findEntityRefs, markdownHeadingSections } from "../../../kernel/src/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import { listTaskIndexPaths, normalizeRelativeDocumentPath, resolveHarnessLayout } from "../../../kernel/src/index.ts";
import { readFrontmatter, readScalar } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { relativePath } from "../cli/path.ts";
import type { CheckProfile, CliResult, CommandRegistryEntry } from "../cli/types.ts";
import { buildResolvableEntityIndex } from "./check-entity-refs.ts";
import { attachDecisionContentPinWarnings } from "./check-decision-content-pin-warnings.ts";
import { profileIssue, type ProfileValidationIssue } from "./check-profile-types.ts";
import { validateJournalActorAttribution } from "./actor-attribution-checker.ts";
import { resolveLiveTaskSectionPolicies } from "./check-live-section-policy.ts";
import { resolveTaskContractDocuments } from "./check-task-contract.ts";
import { validateGateArchitectureRetrospectiveGate } from "./gate-retro-checker.ts";
import { readProjectHarnessSettings, settingsIssue, type ProjectHarnessSettings } from "./settings.ts";
import { bundledTaskDocumentPlaceholderPolicy } from "./core/task-document-placeholders.ts";
import { discoverScriptEntries } from "./extensions/script.ts";
import { runScriptHost } from "./extensions/script-host.ts";
import { validateInReviewExecutionConsistency } from "./task-execution-consistency.ts";

const FORCE_STATUS_AUDIT_MARKER = "FORCE_STATUS_SET_AUDIT";

export function runCheckProfile(
  rootInput: HarnessLayoutInput,
  action: { readonly kind: "check"; readonly profile: CheckProfile; readonly strict: boolean; readonly postMerge: boolean },
  commandRegistry: ReadonlyArray<CommandRegistryEntry>
): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const profilePostMerge = action.postMerge || action.profile === "private-harness" || action.profile === "target-project" || action.strict;
  const projection = checkTaskProjection({ rootDir, layoutOverrides: layoutOverridesFromInput(rootInput), postMerge: profilePostMerge });
  const scriptChecks = runCheckScripts(rootInput);
  const validatorIssues = [
    ...validateJournalActorAttribution(rootInput),
    ...validateCheckProfile(rootInput, action.profile, action.strict),
    ...(action.postMerge ? validateDoneTaskDocumentPlaceholders(rootInput) : []),
    ...scriptChecks.issues
  ];
  const warnings = [...projection.warnings, ...validatorIssues];
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
    scriptChecks: scriptChecks.reports,
    summary: {
      rowCount: projection.rows.length,
      warningCount: warnings.length,
      hardFailCount
    }
  };
  const sourcePackageReport = {
    ...projection.report,
    ok,
    validators: validatorSummary,
    scriptChecks: scriptChecks.reports,
    summary: {
      ...projection.report.summary,
      warningCount: warnings.length,
      hardFailCount
    }
  };
  return {
    ok,
    command: "check",
    profile: action.profile,
    rows: projection.rows.length,
    warnings,
    commands: commandRegistry,
    report: action.profile === "source-package" ? sourcePackageReport : profileReport,
    error: ok ? undefined : cliError(
      projection.report.summary.hardFailCount > 0 ? CliErrorCode.ProjectionCheckFailed : CliErrorCode.CheckProfileFailed,
      `Harness check profile ${action.profile} found hard-fail issues.`
    )
  };
}

function runCheckScripts(rootInput: HarnessLayoutInput): {
  readonly issues: ReadonlyArray<ProfileValidationIssue>;
  readonly reports: ReadonlyArray<Record<string, unknown>>;
} {
  const layout = resolveHarnessLayout(rootInput);
  const issues: ProfileValidationIssue[] = [];
  const reports: Record<string, unknown>[] = [];
  const discovered = discoverScriptEntries(rootInput, "check");
  if (!discovered.ok) {
    const code = discovered.result.error?.code ?? "active_vertical_resolution_failed";
    const hint = discovered.result.error?.hint ?? "The active vertical could not be resolved.";
    issues.push(profileIssue(
      "vertical-check",
      code,
      "hard-fail",
      hint,
      "Fix project active-vertical settings and authorization before running repository checks."
    ));
    reports.push({
      scriptId: null,
      ok: false,
      error: discovered.result.error
    });
    return { issues, reports };
  }
  const checkScripts = discovered.scripts.filter((script) => script.entry.metadata.kind === "check");
  for (const script of checkScripts) {
    const run = runScriptHost({
      rootInput,
      commandName: "check",
      script,
      allowFailedScriptResult: true
    });
    if (!run.ok) {
      issues.push(profileIssue(
        "vertical-check",
        "check_script_failed",
        "hard-fail",
        `${script.entry.id} failed before producing a conformance report.`,
        run.result.error?.hint ?? "Inspect the script evidence bundle and fix the check script failure."
      ));
      reports.push({
        scriptId: script.entry.id,
        ok: false,
        evidenceBundle: run.result.evidenceBundle,
        error: run.result.error
      });
      continue;
    }

    const scriptReport = recordValue(run.scriptedResult.report) ?? run.scriptedResult;
    const report = script.entry.id === "vertical:software-coding:decision-conformance"
      ? attachDecisionContentPinWarnings(rootInput, scriptReport, issues)
      : scriptReport;
    reports.push({
      scriptId: script.entry.id,
      ok: run.scriptedResult.ok,
      evidenceBundle: relativePath(layout.rootDir, run.runDir),
      report
    });

    for (const finding of findingsFromReport(report)) {
      issues.push(profileIssue(
        `vertical-check:${script.entry.id}`,
        finding.type,
        "hard-fail",
        `${finding.ref}: ${finding.message}`,
        finding.hint
      ));
    }
  }
  return { issues, reports };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function findingsFromReport(report: Record<string, unknown>): ReadonlyArray<{
  readonly type: string;
  readonly ref: string;
  readonly message: string;
  readonly hint: string;
}> {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  return findings.flatMap((item) => {
    const finding = recordValue(item);
    if (!finding) return [];
    const type = typeof finding.type === "string" && finding.type ? finding.type : "check_finding";
    const ref = typeof finding.ref === "string" && finding.ref ? finding.ref : "unknown";
    const message = typeof finding.message === "string" && finding.message ? finding.message : "Check script reported a finding.";
    const hint = typeof finding.hint === "string" && finding.hint ? finding.hint : "Resolve or explicitly defer the conformance finding.";
    return [{ type, ref, message, hint }];
  });
}

function validateCheckProfile(rootInput: HarnessLayoutInput, profile: CheckProfile, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const issues: ProfileValidationIssue[] = [
    ...validateUniqueTaskDirectoryIds(layout.rootDir, layout.tasksRoot),
    ...validateInReviewExecutionConsistency(rootInput)
  ];
  const settingsResult = readProjectHarnessSettings(rootInput, "check");
  const settings = settingsResult.ok ? settingsResult.settings : undefined;
  if (!settingsResult.ok) issues.push(settingsIssue(settingsResult));
  if (profile !== "source-package" || strict) {
    const taskDirs = listTaskIndexPaths(rootInput).map((indexPath) => path.dirname(indexPath));
    const placeholderPolicy = bundledTaskDocumentPlaceholderPolicy();
    for (const taskDir of taskDirs) {
      issues.push(...validateTaskPackageContracts(rootInput, taskDir, profile, strict, placeholderPolicy, settings));
    }
    issues.push(...validateMilestoneDossierGate(rootInput, taskDirs));
    issues.push(...validateGateArchitectureRetrospectiveGate(rootInput, taskDirs));
  }

  if (profile === "private-harness" || profile === "target-project") {
    issues.push(...validateContextDocs(rootDir, strict));
    issues.push(...validateGovernanceGeneratedViews(rootInput, strict));
  }

  return issues;
}

function validateUniqueTaskDirectoryIds(rootDir: string, tasksRoot: string): ReadonlyArray<ProfileValidationIssue> {
  if (!existsSync(tasksRoot)) return [];
  const directoriesByTaskId = new Map<string, string[]>();
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = /^(task_[0-9A-HJKMNP-TV-Z]{26})(?:-|$)/u.exec(entry.name);
    if (!match?.[1]) continue;
    const paths = directoriesByTaskId.get(match[1]) ?? [];
    paths.push(relativePath(rootDir, path.join(tasksRoot, entry.name)));
    directoriesByTaskId.set(match[1], paths);
  }
  return [...directoriesByTaskId.entries()]
    .filter(([, paths]) => paths.length >= 2)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taskId, paths]) => profileIssue(
      "completion-consistency",
      "duplicate_task_directory_id",
      "hard-fail",
      `Task id ${taskId} has multiple task directories: ${paths.sort().join(", ")}.`,
      "Keep exactly one canonical task directory for this task id and migrate any misplaced authored content before removing duplicates."
    ));
}

function validateTaskPackageContracts(
  rootInput: HarnessLayoutInput,
  taskDir: string,
  profile: CheckProfile,
  strict: boolean,
  placeholderPolicy: TaskDocumentPlaceholderPolicy,
  settings?: ProjectHarnessSettings
): ReadonlyArray<ProfileValidationIssue> {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
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
  issues.push(...validateMetadataDrivenTaskPackage(rootInput, taskDir, relativeTaskDir, frontmatter, settings));

  const taskPlanPath = path.join(taskDir, "task_plan.md");
  if (!existsSync(taskPlanPath)) {
    issues.push(profileIssue("task-plan-contract", "task_plan_missing", "hard-fail", `${relativeTaskDir}/task_plan.md is missing.`, "Restore task_plan.md from the task template or supersede the package."));
  } else {
    const taskPlanBody = readFileSync(taskPlanPath, "utf8");
    if (!/Task Contract:\s*harness-task(?:\/|\s+)v1/u.test(taskPlanBody) && profile !== "source-package") {
      issues.push(profileIssue("task-plan-contract", "task_contract_marker_missing", strictSeverity(strict), `${relativeTaskDir}/task_plan.md lacks Task Contract: harness-task/v1.`, "Add the task contract marker or keep this package outside strict M2 profiles."));
    }
    if (isTaskDocumentPlaceholderMarkdown(taskPlanBody, placeholderPolicy.taskPlanPlaceholderFingerprintSets)) {
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
      issues.push(profileIssue("review-schema", "review_schema_invalid", "hard-fail", `${relativeTaskDir}/review.md failed review schema validation.`, `${JSON.stringify(issue)} Valid severity values: P0, P1, P2, P3.`));
    }
  }

  const visualPath = path.join(taskDir, "visual_map.md");
  if (existsSync(visualPath)) {
    const visualBody = readFileSync(visualPath, "utf8");
    if (!/\| Phase ID \| Kind \| Depends On \| State \| Completion \|/u.test(visualBody)) {
      issues.push(profileIssue("visual-map", "visual_phase_table_missing", strictSeverity(strict), `${relativeTaskDir}/visual_map.md lacks the canonical phase table.`, "Add the Visual Map Contract phase table."));
    }
    if (isTaskDocumentPlaceholderMarkdown(visualBody, placeholderPolicy.visualMapPlaceholderFingerprintSets)) {
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
    if (isTaskDocumentPlaceholderMarkdown(lessonBody, placeholderPolicy.lessonCandidatesPlaceholderFingerprintSets)) {
      issues.push(profileIssue("lesson-routing", "lesson_placeholder", strictSeverity(strict), `${relativeTaskDir}/lesson_candidates.md contains unresolved placeholders.`, "Resolve lesson candidate routing before closeout."));
    }
  }

  const status = readScalar(frontmatter, "  status");
  if ((status === "done" || status === "in_review") && !existsSync(path.join(taskDir, "closeout.md"))) {
    issues.push(profileIssue("completion-consistency", "closeout_missing", strictSeverity(strict), `${relativeTaskDir} is ${status} without closeout evidence.`, "Add closeout.md before claiming completion."));
  }

  return issues;
}

function validateDoneTaskDocumentPlaceholders(rootInput: HarnessLayoutInput): ReadonlyArray<ProfileValidationIssue> {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const policy = bundledTaskDocumentPlaceholderPolicy();
  const issues: ProfileValidationIssue[] = [];
  for (const indexPath of listTaskIndexPaths(rootInput)) {
    const taskDir = path.dirname(indexPath);
    const relativeTaskDir = relativePath(rootDir, taskDir);
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
    if (!frontmatter || readScalar(frontmatter, "  status") !== "done") continue;

    const closeoutPath = path.join(taskDir, "closeout.md");
    if (existsSync(closeoutPath) && isCloseoutPlaceholderMarkdown(readFileSync(closeoutPath, "utf8"), policy.closeoutPlaceholderFingerprints)) {
      issues.push(profileIssue(
        "completion-consistency",
        "closeout_placeholder",
        "hard-fail",
        `${relativeTaskDir}/closeout.md still contains template placeholder text.`,
        "Replace closeout.md placeholders with Summary, Verification, and Residual Risk evidence before treating the task as done."
      ));
    }

  }
  return issues;
}

function validateMetadataDrivenTaskPackage(
  rootInput: HarnessLayoutInput,
  taskDir: string,
  relativeTaskDir: string,
  frontmatter: string,
  settings?: ProjectHarnessSettings
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
  const contract = resolveTaskContractDocuments(rootInput, taskDir, relativeTaskDir, vertical, presetId, profile, settings);
  if (!contract.ok) return contract.issues;
  const livePolicy = resolveLiveTaskSectionPolicies(rootInput, relativeTaskDir, vertical, presetId, profile, contract.documents);
  if (!livePolicy.ok) return livePolicy.issues;
  const issues: ProfileValidationIssue[] = [];
  for (const document of contract.documents) {
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
    const liveDocument = livePolicy.documents.get(document.materializeAs);
    if (!liveDocument) {
      issues.push(profileIssue(
        "metadata-template",
        "metadata_section_permission_missing",
        "hard-fail",
        `${relativeDocumentPath} has no active template section policy.`,
        "Restore an active template declaration for this frozen contract document."
      ));
      continue;
    }
    const permissions = new Map(liveDocument.sectionPermissions.map((permission) => [permission.anchor, permission]));
    for (const section of markdownHeadingSections(body)) {
      if (permissions.has(section.anchor)) continue;
      issues.push(profileIssue(
        "metadata-template",
        "metadata_section_permission_missing",
        "hard-fail",
        `${relativeDocumentPath} contains undeclared section ${section.anchor}.`,
        "Declare the heading in the selected template sectionPermissions before canonical writes are allowed."
      ));
    }
    for (const permission of liveDocument.sectionPermissions) {
      if (permission.writeMode !== "forbidden") continue;
      const templateSection = extractMarkdownSection(liveDocument.body, permission.anchor);
      const actualSection = extractMarkdownSection(body, permission.anchor);
      if (templateSection === actualSection) continue;
      issues.push(profileIssue(
        "metadata-template",
        "metadata_forbidden_section_changed",
        "hard-fail",
        `${relativeDocumentPath} changed forbidden section ${permission.anchor}.`,
        "Restore the template-owned section; forbidden sections have no canonical prose write road."
      ));
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

function validateGovernanceGeneratedViews(rootInput: HarnessLayoutInput, strict: boolean): ReadonlyArray<ProfileValidationIssue> {
  const layout = resolveHarnessLayout(rootInput);
  const issues: ProfileValidationIssue[] = [];
  const generatedRegistry = path.join(layout.generatedRoot, "Module-Registry.md");
  const authoredModules = path.join(layout.authoredRoot, "modules.json");
  if (existsSync(authoredModules) && !existsSync(generatedRegistry)) {
    issues.push(profileIssue("governance-boundary", "module_registry_projection_missing", strictSeverity(strict), ".harness/generated/Module-Registry.md is missing for authored modules.json.", "Run harness-anything module scaffold/register or governance rebuild to regenerate local views."));
  }
  return issues;
}

function validateMilestoneDossierGate(rootInput: HarnessLayoutInput, taskDirs: ReadonlyArray<string>): ReadonlyArray<ProfileValidationIssue> {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  const index = buildResolvableEntityIndex(rootInput);
  const issues: ProfileValidationIssue[] = [];
  for (const taskDir of taskDirs) {
    const relativeTaskDir = relativePath(rootDir, taskDir);
    const indexPath = path.join(taskDir, "INDEX.md");
    if (!existsSync(indexPath)) continue;
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
    if (!frontmatter || readScalar(frontmatter, "preset") !== "milestone-dossier") continue;

    const dossierPath = path.join(taskDir, "artifacts", "dossier.html");
    if (!existsSync(dossierPath)) {
      issues.push(profileIssue(
        "dossier-gate-checker",
        "dossier_html_missing",
        "hard-fail",
        `${relativeTaskDir}/artifacts/dossier.html is required by preset milestone-dossier.`,
        "Run the milestone-dossier gather entrypoint, write the understanding dossier by hand, and keep it under the coordination task artifacts directory."
      ));
      continue;
    }

    let body: string;
    try {
      body = readFileSync(dossierPath, "utf8");
    } catch {
      issues.push(profileIssue(
        "dossier-gate-checker",
        "dossier_html_unreadable",
        "hard-fail",
        `${relativeTaskDir}/artifacts/dossier.html could not be read as UTF-8 text.`,
        "Restore a readable HTML dossier artifact."
      ));
      continue;
    }

    const unresolved = [...new Set(findEntityRefs(body)
      .filter((ref) => !ref.externalHarness)
      .map((ref) => ref.raw))]
      .filter((ref) => !index.refs.has(ref));
    for (const ref of unresolved) {
      issues.push(profileIssue(
        "dossier-gate-checker",
        "dossier_entity_ref_unresolved",
        "hard-fail",
        `${relativeTaskDir}/artifacts/dossier.html references unresolved entity ${ref}.`,
        "Replace bubble references with real task, decision, or fact refs from authored Harness packages."
      ));
    }
  }
  return issues;
}

function layoutOverridesFromInput(rootInput: HarnessLayoutInput): HarnessLayoutOverrides | undefined {
  return typeof rootInput === "string" ? undefined : rootInput.layoutOverrides;
}

function strictSeverity(strict: boolean): "warning" | "hard-fail" {
  return strict ? "hard-fail" : "warning";
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
