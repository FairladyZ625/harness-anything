import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect, Schema } from "effect";
import { resolveTaskCreatedBy } from "../../../adapters/local/src/created-by.ts";
import { indexPath, makeIndex, renderIndex } from "../../../adapters/local/src/task-index.ts";
import { taskEntityId, type EngineError, type WriteError } from "../../../kernel/src/index.ts";
import { stablePayloadHash } from "../../../kernel/src/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { createTaskPackagePath, generateTaskId, resolveHarnessLayout, slugifyTaskTitle } from "../../../kernel/src/index.ts";
import { LegacyIndexSchema, type LegacyIndexEntry } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";

type NewTaskAction = Extract<ParsedCommand["action"], { readonly kind: "new-task" }>;

type LegacyRebuildSource =
  | { readonly ok: true; readonly entry: LegacyIndexEntry }
  | { readonly ok: false; readonly result: CliResult };

interface LegacyProvenance {
  readonly schema: "legacy-rebuild-provenance/v1";
  readonly legacyId: string;
  readonly legacyIndexPath: "harness/legacy/index.json";
  readonly sourcePath: string;
  readonly storedPath: string;
  readonly sourceDigest: string;
  readonly title?: string;
  readonly category: "task" | "doc";
  readonly detectedStatus?: LegacyIndexEntry["detectedStatus"];
  readonly recommendedTreatment: LegacyIndexEntry["recommendedTreatment"];
  readonly humanReviewRequired: boolean;
  readonly evidencePointers: LegacyIndexEntry["evidencePointers"];
  readonly rebuiltAt: string;
}

export function runNewTaskFromLegacy(
  rootInput: HarnessLayoutInput,
  action: NewTaskAction,
  makeWriteCoordinator: (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => WriteCoordinator
): Effect.Effect<CliResult, EngineError | WriteError> {
  if (!action.fromLegacyId) {
    throw new Error("runNewTaskFromLegacy requires fromLegacyId");
  }
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const fromLegacyId = action.fromLegacyId;
  return Effect.sync(() => readLegacyRebuildSource(rootInput, fromLegacyId)).pipe(
    Effect.flatMap((legacySource): Effect.Effect<CliResult, EngineError | WriteError> => {
      if (!legacySource.ok) return Effect.succeed(legacySource.result);
      const title = action.titleProvided ? action.title : legacySource.entry.title ?? legacySource.entry.id;
      const slug = action.slugProvided ? action.slug : slugifyTaskTitle(title);
      const taskId = generateTaskId();
      if (existsSync(indexPath(rootInput, taskId))) {
        return Effect.fail({ _tag: "TaskAlreadyExists", taskId } satisfies EngineError);
      }
      const createdAt = new Date().toISOString();
      const index = makeIndex({
        taskId,
        title,
        status: "planned",
        bindingCreatedAt: createdAt,
        vertical: "default",
        preset: "default",
        provenance: [{
          runtime: "human",
          sessionId: `human-cli-${Date.parse(createdAt)}`,
          boundAt: createdAt
        }],
        createdBy: resolveTaskCreatedBy(rootDir)
      }, hashPayload);
      const packagePath = createTaskPackagePath(rootInput, taskId, slug);
      const provenance = buildLegacyProvenance(legacySource.entry, createdAt);
      const provenanceMd = renderLegacyProvenanceMarkdown(rootDir, packagePath, legacySource.entry);
      const coordinator = makeWriteCoordinator({ kind: "agent", id: "legacy-rebuild" });
      const writes = [
        { taskId, path: "INDEX.md", body: renderIndex(index), packageSlug: slug },
        { taskId, path: "legacy-provenance.json", body: `${JSON.stringify(provenance, null, 2)}\n`, packageSlug: slug },
        { taskId, path: "legacy-provenance.md", body: provenanceMd, packageSlug: slug }
      ];
      const opId = `${Date.now()}-${hashPayload({ kind: "package_create", writes }).slice(0, 16)}`;
      return coordinator.enqueue({
        opId,
        entityId: taskEntityId(taskId),
        kind: "package_create",
        payload: { writes }
      }).pipe(
        Effect.flatMap(() => coordinator.flush("explicit")),
        Effect.map((): CliResult => {
          return {
            ok: true,
            command: "new-task",
            taskId,
            slug,
            status: "planned",
            packagePath: path.relative(rootDir, packagePath).split(path.sep).join("/"),
            report: {
              schema: "legacy-rebuild-report/v1",
              source: provenance,
              inheritedTaskId: false,
              inheritedStatus: false
            }
          };
        })
      );
    })
  );
}

function hashPayload(value: unknown): string {
  return stablePayloadHash(value);
}

function readLegacyRebuildSource(rootInput: HarnessLayoutInput, legacyId: string): LegacyRebuildSource {
  const layout = resolveHarnessLayout(rootInput);
  const rootDir = layout.rootDir;
  if (!existsSync(layout.legacyIndexPath)) {
    return {
      ok: false,
      result: {
        ok: false,
        command: "new-task",
        error: cliError(CliErrorCode.LegacyIndexMissing, "harness/legacy/index.json is missing. Run legacy index <path> --apply before rebuilding from legacy.")
      }
    };
  }
  try {
    const index = Schema.decodeUnknownSync(LegacyIndexSchema)(JSON.parse(readFileSync(layout.legacyIndexPath, "utf8")));
    const entry = index.entries.find((candidate) => candidate.id === legacyId);
    if (!entry) {
      return {
        ok: false,
        result: {
          ok: false,
          command: "new-task",
          error: cliError(CliErrorCode.LegacyEntryNotFound, `No legacy index entry found for id: ${legacyId}`)
        }
      };
    }
    if (!existsSync(path.join(rootDir, entry.storedPath))) {
      return {
        ok: false,
        result: {
          ok: false,
          command: "new-task",
          error: cliError(CliErrorCode.LegacyStoredPathMissing, `Legacy stored path is missing: ${entry.storedPath}`)
        }
      };
    }
    return { ok: true, entry };
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        command: "new-task",
        error: cliError(CliErrorCode.LegacyIndexInvalid, "harness/legacy/index.json does not match the runtime LegacyIndexSchema.")
      }
    };
  }
}

function buildLegacyProvenance(entry: LegacyIndexEntry, rebuiltAt: string): LegacyProvenance {
  return {
    schema: "legacy-rebuild-provenance/v1",
    legacyId: entry.id,
    legacyIndexPath: "harness/legacy/index.json",
    sourcePath: entry.sourcePath,
    storedPath: entry.storedPath,
    sourceDigest: entry.sourceDigest,
    title: entry.title,
    category: entry.category,
    detectedStatus: entry.detectedStatus,
    recommendedTreatment: entry.recommendedTreatment,
    humanReviewRequired: entry.humanReviewRequired,
    evidencePointers: entry.evidencePointers,
    rebuiltAt
  };
}

function renderLegacyProvenanceMarkdown(rootDir: string, packagePath: string, entry: LegacyIndexEntry): string {
  const relativePath = path.relative(rootDir, packagePath).split(path.sep).join("/");
  return [
    "# Legacy Rebuild Provenance",
    "",
    `Task package: ${relativePath}`,
    `Legacy id: ${entry.id}`,
    `Legacy source path: ${entry.sourcePath}`,
    `Legacy stored path: ${entry.storedPath}`,
    `Source digest: ${entry.sourceDigest}`,
    `Recommended treatment: ${entry.recommendedTreatment}`,
    `Human review required: ${entry.humanReviewRequired ? "yes" : "no"}`,
    "",
    "This task was rebuilt as a fresh Harness Anything task. It does not inherit the legacy task id, lifecycle status, or package identity.",
    ""
  ].join("\n");
}
