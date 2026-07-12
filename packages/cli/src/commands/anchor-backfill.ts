import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { TaskId, WriteError } from "../../../kernel/src/index.ts";
import type { MaterializedTemplatePlan } from "../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { listTaskIndexPaths, normalizeRelativeDocumentPath, readFrontmatter, readScalar, resolveHarnessLayout } from "../../../kernel/src/index.ts";
import { stablePayloadHash, writeCoordinatedTaskDocuments } from "../../../kernel/src/write-coordination/write-helpers.ts";
import type { CommandRunnerContext } from "../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import { isInvalidPreset, materializePresetTaskDocuments, resolvePresetEntry } from "./extensions/state.ts";
import { readProjectHarnessSettings } from "./settings.ts";

type MigrateAnchorsAction = Extract<ParsedCommand["action"], { readonly kind: "migrate-anchors" }>;

interface AnchorInsertion {
  readonly anchor: string;
  readonly insertedAfter?: string;
  readonly insertedBefore?: string;
}

interface AnchorBackfillEntry {
  readonly taskId: TaskId;
  readonly path: string;
  readonly documentPath: string;
  readonly preset: string;
  readonly profile?: string;
  readonly slot: string;
  readonly locale: "zh-CN" | "en-US";
  readonly anchors: ReadonlyArray<AnchorInsertion>;
  readonly body: string;
}

interface AnchorBackfillSkippedEntry {
  readonly path: string;
  readonly reason:
    | "missing_frontmatter"
    | "not_software_coding"
    | "missing_preset"
    | "preset_not_found"
    | "preset_invalid"
    | "materialization_failed"
    | "invalid_materialized_path"
    | "materialized_document_missing"
    | "materialized_document_unreadable"
    | "duplicate_task_id"
    | "template_anchor_missing";
  readonly detail?: string;
}

interface AnchorBackfillReport {
  readonly schema: "anchor-backfill-report/v1";
  readonly mode: "dry-run" | "apply";
  readonly locale: "zh-CN" | "en-US";
  readonly summary: {
    readonly scannedTasks: number;
    readonly scannedDocuments: number;
    readonly needsBackfill: number;
    readonly missingAnchors: number;
    readonly alreadyComplete: number;
    readonly skipped: number;
    readonly appliedDocuments: number;
    readonly appliedAnchors: number;
  };
  readonly entries: ReadonlyArray<{
    readonly taskId: string;
    readonly path: string;
    readonly preset: string;
    readonly profile?: string;
    readonly slot: string;
    readonly locale: "zh-CN" | "en-US";
    readonly anchors: ReadonlyArray<AnchorInsertion>;
  }>;
  readonly skipped: ReadonlyArray<AnchorBackfillSkippedEntry>;
}

interface ScanResult {
  readonly scannedTasks: number;
  readonly scannedDocuments: number;
  readonly alreadyComplete: number;
  readonly entries: ReadonlyArray<AnchorBackfillEntry>;
  readonly skipped: ReadonlyArray<AnchorBackfillSkippedEntry>;
}

interface MarkdownSection {
  readonly heading: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function runMigrateAnchors(
  context: CommandRunnerContext,
  rootInput: HarnessLayoutInput,
  action: MigrateAnchorsAction
): Effect.Effect<CliResult, WriteError> {
  const settingsResult = readProjectHarnessSettings(rootInput, "migrate-anchors");
  if (!settingsResult.ok) return Effect.succeed(settingsResult.result);

  const locale = settingsResult.settings.locale ?? "zh-CN";
  const scan = scanAnchorBackfill(rootInput, locale);
  const report = (appliedDocuments: number, appliedAnchors: number): AnchorBackfillReport => ({
    schema: "anchor-backfill-report/v1",
    mode: action.mode,
    locale,
    summary: {
      scannedTasks: scan.scannedTasks,
      scannedDocuments: scan.scannedDocuments,
      needsBackfill: scan.entries.length,
      missingAnchors: scan.entries.reduce((sum, entry) => sum + entry.anchors.length, 0),
      alreadyComplete: scan.alreadyComplete,
      skipped: scan.skipped.length,
      appliedDocuments,
      appliedAnchors
    },
    entries: scan.entries.map((entry) => ({
      taskId: entry.taskId,
      path: entry.path,
      preset: entry.preset,
      profile: entry.profile,
      slot: entry.slot,
      locale: entry.locale,
      anchors: entry.anchors
    })),
    skipped: scan.skipped
  });

  if (action.mode === "dry-run" || scan.entries.length === 0) {
    return Effect.succeed(anchorBackfillResult(action, report(0, 0)));
  }

  const coordinator = context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "anchor-backfill" });
  return writeCoordinatedTaskDocuments(coordinator, stablePayloadHash, scan.entries.map((entry) => ({
    taskId: entry.taskId,
    path: entry.documentPath,
    body: entry.body,
    kind: "doc_write"
  }))).pipe(
    Effect.map(() => anchorBackfillResult(action, report(
      scan.entries.length,
      scan.entries.reduce((sum, entry) => sum + entry.anchors.length, 0)
    )))
  );
}

function anchorBackfillResult(action: MigrateAnchorsAction, report: AnchorBackfillReport): CliResult {
  return {
    ok: true,
    command: "migrate-anchors",
    migrationMode: action.mode === "apply" ? "apply" : "plan",
    rows: report.summary.missingAnchors,
    report
  };
}

function scanAnchorBackfill(rootInput: HarnessLayoutInput, locale: "zh-CN" | "en-US"): ScanResult {
  const layout = resolveHarnessLayout(rootInput);
  const indexPaths = listTaskIndexPaths(rootInput);
  const duplicateTaskIds = findDuplicateTaskIds(layout.rootDir, indexPaths);
  const entries: AnchorBackfillEntry[] = [];
  const skipped: AnchorBackfillSkippedEntry[] = [];
  let scannedDocuments = 0;
  let alreadyComplete = 0;

  for (const indexPath of indexPaths) {
    const taskDir = path.dirname(indexPath);
    const relativeIndexPath = relativeRootPath(layout.rootDir, indexPath);
    const indexBody = readFileSync(indexPath, "utf8");
    const frontmatter = readFrontmatter(indexBody);
    if (!frontmatter) {
      skipped.push({ path: relativeIndexPath, reason: "missing_frontmatter" });
      continue;
    }

    const taskId = (readScalar(frontmatter, "task_id") || path.basename(taskDir)) as TaskId;
    const duplicateTaskPaths = duplicateTaskIds.get(taskId);
    if (duplicateTaskPaths) {
      skipped.push({
        path: relativeIndexPath,
        reason: "duplicate_task_id",
        detail: `${taskId} appears in ${duplicateTaskPaths.join(", ")}`
      });
      continue;
    }

    const vertical = readScalar(frontmatter, "vertical");
    if (vertical !== "software/coding") {
      skipped.push({ path: relativeIndexPath, reason: "not_software_coding", detail: vertical ?? "missing vertical" });
      continue;
    }

    const presetId = readScalar(frontmatter, "preset");
    if (!presetId || presetId === "default") {
      skipped.push({ path: relativeIndexPath, reason: "missing_preset" });
      continue;
    }

    const preset = resolvePresetEntry(rootInput, presetId);
    if (!preset) {
      skipped.push({ path: relativeIndexPath, reason: "preset_not_found", detail: presetId });
      continue;
    }
    if (isInvalidPreset(preset)) {
      skipped.push({ path: relativeIndexPath, reason: "preset_invalid", detail: preset.issues.map((issue) => issue.code).join(", ") });
      continue;
    }

    const profile = readScalar(frontmatter, "profile") || undefined;
    const materialized = materializePresetTaskDocuments(preset.manifest, { profileId: profile, locale });
    if (!materialized.ok) {
      skipped.push({ path: relativeIndexPath, reason: "materialization_failed", detail: materialized.issues.map((issue) => issue.code).join(", ") });
      continue;
    }

    for (const document of materialized.documents) {
      let safeDocumentPath: string;
      try {
        safeDocumentPath = normalizeRelativeDocumentPath(document.materializeAs);
      } catch (error) {
        skipped.push({
          path: `${relativeRootPath(layout.rootDir, taskDir)}/${document.materializeAs}`,
          reason: "invalid_materialized_path",
          detail: error instanceof Error ? error.message : "invalid path"
        });
        continue;
      }

      const documentPath = path.join(taskDir, safeDocumentPath);
      const relativeDocumentPath = relativeRootPath(layout.rootDir, documentPath);
      if (!existsSync(documentPath)) {
        skipped.push({ path: relativeDocumentPath, reason: "materialized_document_missing", detail: document.slot });
        continue;
      }

      scannedDocuments += 1;
      let body: string;
      try {
        body = readFileSync(documentPath, "utf8");
      } catch (error) {
        skipped.push({
          path: relativeDocumentPath,
          reason: "materialized_document_unreadable",
          detail: error instanceof Error ? error.message : "could not be read as a file"
        });
        continue;
      }
      const patched = patchMissingAnchors(body, document);
      if (!patched.ok) {
        skipped.push({ path: relativeDocumentPath, reason: "template_anchor_missing", detail: patched.anchor });
        continue;
      }
      if (!patched.changed) {
        alreadyComplete += 1;
        continue;
      }
      entries.push({
        taskId,
        path: relativeDocumentPath,
        documentPath: safeDocumentPath,
        preset: presetId,
        profile,
        slot: document.slot,
        locale: document.locale,
        anchors: patched.insertions,
        body: patched.body
      });
    }
  }

  return {
    scannedTasks: indexPaths.length,
    scannedDocuments,
    alreadyComplete,
    entries,
    skipped
  };
}

function findDuplicateTaskIds(
  rootDir: string,
  indexPaths: ReadonlyArray<string>
): ReadonlyMap<string, ReadonlyArray<string>> {
  const pathsByTaskId = new Map<string, string[]>();
  for (const indexPath of indexPaths) {
    const taskDir = path.dirname(indexPath);
    const body = readFileSync(indexPath, "utf8");
    const frontmatter = readFrontmatter(body);
    if (!frontmatter) continue;
    const taskId = readScalar(frontmatter, "task_id") || path.basename(taskDir);
    const paths = pathsByTaskId.get(taskId) ?? [];
    paths.push(relativeRootPath(rootDir, indexPath));
    pathsByTaskId.set(taskId, paths);
  }

  return new Map([...pathsByTaskId].filter(([, paths]) => paths.length > 1));
}

function patchMissingAnchors(
  body: string,
  document: MaterializedTemplatePlan
): { readonly ok: false; readonly anchor: string } | { readonly ok: true; readonly changed: false } | { readonly ok: true; readonly changed: true; readonly body: string; readonly insertions: ReadonlyArray<AnchorInsertion> } {
  const templateSections = markdownSections(document.body);
  const requiredSections: Array<{ readonly anchor: string; readonly section: MarkdownSection }> = [];
  for (const anchor of document.requiredAnchors) {
    const section = templateSections.find((candidate) => candidate.heading === anchor);
    if (!section) return { ok: false, anchor };
    requiredSections.push({ anchor, section });
  }

  let patched = body;
  const insertions: AnchorInsertion[] = [];
  for (const entry of requiredSections) {
    if (patched.includes(entry.anchor)) continue;
    const insertion = insertTemplateSection(patched, templateSections, entry.section);
    patched = insertion.body;
    insertions.push({
      anchor: entry.anchor,
      insertedAfter: insertion.insertedAfter,
      insertedBefore: insertion.insertedBefore
    });
  }

  if (insertions.length === 0) return { ok: true, changed: false };
  return { ok: true, changed: true, body: patched, insertions };
}

function insertTemplateSection(
  body: string,
  templateSections: ReadonlyArray<MarkdownSection>,
  section: MarkdownSection
): { readonly body: string; readonly insertedAfter?: string; readonly insertedBefore?: string } {
  const sectionIndex = templateSections.findIndex((candidate) => candidate.heading === section.heading);
  const existingSections = markdownSections(body);

  for (let index = sectionIndex - 1; index >= 0; index -= 1) {
    const previous = existingSections.find((candidate) => candidate.heading === templateSections[index]?.heading);
    if (previous) {
      return {
        body: insertAt(body, previous.end, section.text),
        insertedAfter: previous.heading
      };
    }
  }

  for (let index = sectionIndex + 1; index < templateSections.length; index += 1) {
    const next = existingSections.find((candidate) => candidate.heading === templateSections[index]?.heading);
    if (next) {
      return {
        body: insertAt(body, next.start, section.text),
        insertedBefore: next.heading
      };
    }
  }

  return {
    body: `${body.replace(/\s*$/u, "")}\n\n${section.text.replace(/\s*$/u, "")}\n`,
  };
}

function insertAt(body: string, offset: number, sectionText: string): string {
  const prefix = body.slice(0, offset).replace(/\s*$/u, "");
  const suffix = body.slice(offset).replace(/^\s*/u, "");
  return `${prefix}\n\n${sectionText.replace(/\s*$/u, "")}\n\n${suffix}`;
}

function markdownSections(body: string): ReadonlyArray<MarkdownSection> {
  const matches = [...body.matchAll(/^##(?!#)\s+.+$/gmu)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? body.length;
    return {
      heading: (match[0] ?? "").replace(/\r$/u, ""),
      start,
      end,
      text: body.slice(start, end)
    };
  });
}

function relativeRootPath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}
