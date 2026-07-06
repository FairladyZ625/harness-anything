import { readFileSync } from "node:fs";
import path from "node:path";
import { Effect, Schema } from "effect";
import type { CurrentSessionRef } from "../../../../kernel/src/index.ts";
import type { TaskId, WriteError } from "../../../../kernel/src/index.ts";
import { stablePayloadHash } from "../../../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { listTaskIndexPaths, readFrontmatter, readScalar, resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import { ProvenanceEntrySchema } from "../../../../kernel/src/index.ts";
import { writeCoordinatedTaskDocuments } from "../../../../kernel/src/write-coordination/write-helpers.ts";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type MigrateProvenanceAction = Extract<ParsedCommand["action"], { readonly kind: "migrate-provenance" }>;

interface BackfillEntry {
  readonly taskId: TaskId;
  readonly path: string;
  readonly body: string;
}

interface BackfillSkippedEntry {
  readonly path: string;
  readonly reason: "missing_frontmatter" | "not_task_package";
}

interface ProvenanceBackfillReport {
  readonly schema: "provenance-backfill-report/v1";
  readonly mode: "dry-run" | "apply";
  readonly provenance: {
    readonly runtime: CurrentSessionRef["runtime"];
    readonly sessionId: string;
    readonly boundAt: string;
  };
  readonly summary: {
    readonly scanned: number;
    readonly needsBackfill: number;
    readonly alreadyPresent: number;
    readonly skipped: number;
    readonly applied: number;
  };
  readonly entries: ReadonlyArray<{ readonly taskId: string; readonly path: string }>;
  readonly skipped: ReadonlyArray<BackfillSkippedEntry>;
}

export function runMigrateProvenance(
  context: CommandRunnerContext,
  rootInput: HarnessLayoutInput,
  action: MigrateProvenanceAction
): Effect.Effect<CliResult, WriteError> {
  const boundAt = new Date().toISOString();
  return context.currentSessionProbe.currentSession.pipe(
    Effect.flatMap((session) => {
      const provenance = syntheticProvenance(boundAt, session);
      const scan = scanTaskIndexes(rootInput, provenance);
      const report = (applied: number): ProvenanceBackfillReport => ({
        schema: "provenance-backfill-report/v1",
        mode: action.mode,
        provenance,
        summary: {
          scanned: scan.scanned,
          needsBackfill: scan.entries.length,
          alreadyPresent: scan.alreadyPresent,
          skipped: scan.skipped.length,
          applied
        },
        entries: scan.entries.map((entry) => ({ taskId: entry.taskId, path: entry.path })),
        skipped: scan.skipped
      });

      if (action.mode === "dry-run" || scan.entries.length === 0) {
        return Effect.succeed(result(action, report(0)));
      }

      const coordinator = context.makeWriteCoordinator({ kind: "agent", id: "provenance-backfill" });
      return writeCoordinatedTaskDocuments(coordinator, stablePayloadHash, scan.entries.map((entry) => ({
        taskId: entry.taskId,
        path: "INDEX.md",
        body: entry.body,
        kind: "doc_write"
      }))).pipe(
        Effect.map(() => result(action, report(scan.entries.length)))
      );
    })
  );
}

function result(action: MigrateProvenanceAction, report: ProvenanceBackfillReport): CliResult {
  return {
    ok: true,
    command: "migrate-provenance",
    migrationMode: action.mode === "apply" ? "apply" : "plan",
    rows: report.summary.needsBackfill,
    report
  };
}

function scanTaskIndexes(
  rootInput: HarnessLayoutInput,
  provenance: ProvenanceBackfillReport["provenance"]
): {
  readonly scanned: number;
  readonly alreadyPresent: number;
  readonly entries: ReadonlyArray<BackfillEntry>;
  readonly skipped: ReadonlyArray<BackfillSkippedEntry>;
} {
  const layout = resolveHarnessLayout(rootInput);
  const indexPaths = listTaskIndexPaths(rootInput);
  const entries: BackfillEntry[] = [];
  const skipped: BackfillSkippedEntry[] = [];
  let alreadyPresent = 0;
  for (const indexPath of indexPaths) {
    const body = readFileSync(indexPath, "utf8");
    const relativePath = path.relative(layout.rootDir, indexPath).split(path.sep).join("/");
    const frontmatter = readFrontmatter(body);
    if (!frontmatter) {
      skipped.push({ path: relativePath, reason: "missing_frontmatter" });
      continue;
    }
    if (readScalar(frontmatter, "schema") !== "task-package/v2") {
      skipped.push({ path: relativePath, reason: "not_task_package" });
      continue;
    }
    const taskId = (readScalar(frontmatter, "task_id") || path.basename(path.dirname(indexPath))) as TaskId;
    const patched = patchMissingProvenance(body, provenance);
    if (!patched) {
      alreadyPresent += 1;
      continue;
    }
    entries.push({ taskId, path: relativePath, body: patched });
  }
  return {
    scanned: indexPaths.length,
    alreadyPresent,
    entries,
    skipped
  };
}

function patchMissingProvenance(
  body: string,
  provenance: ProvenanceBackfillReport["provenance"]
): string | null {
  const match = body.match(/^---\n([\s\S]*?)\n---\n?/u);
  if (!match) return null;
  const frontmatter = match[1] ?? "";
  const lines = frontmatter.split("\n");
  const provenanceIndex = lines.findIndex((line) => line === "provenance:");
  const provenanceLine = `  - {runtime: ${JSON.stringify(provenance.runtime)}, sessionId: ${JSON.stringify(provenance.sessionId)}, boundAt: ${JSON.stringify(provenance.boundAt)}}`;

  if (provenanceIndex >= 0) {
    const blockEnd = findBlockEnd(lines, provenanceIndex + 1);
    const block = lines.slice(provenanceIndex + 1, blockEnd);
    if (block.some((line) => line.trim().startsWith("- "))) return null;
    const patchedLines = [
      ...lines.slice(0, provenanceIndex + 1),
      provenanceLine,
      ...lines.slice(blockEnd)
    ];
    return rebuildFrontmatter(body, match[0], patchedLines);
  }

  const insertionIndex = insertionPoint(lines);
  const patchedLines = [
    ...lines.slice(0, insertionIndex),
    "provenance:",
    provenanceLine,
    ...lines.slice(insertionIndex)
  ];
  return rebuildFrontmatter(body, match[0], patchedLines);
}

function findBlockEnd(lines: ReadonlyArray<string>, start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/u.test(lines[index] ?? "")) return index;
  }
  return lines.length;
}

function insertionPoint(lines: ReadonlyArray<string>): number {
  const profileIndex = lines.findIndex((line) => line.startsWith("profile:"));
  if (profileIndex >= 0) return profileIndex;
  const createdByIndex = lines.findIndex((line) => line === "createdBy:");
  if (createdByIndex >= 0) return createdByIndex;
  const presetIndex = lines.findIndex((line) => line.startsWith("preset:"));
  return presetIndex >= 0 ? presetIndex + 1 : lines.length;
}

function rebuildFrontmatter(body: string, originalBlock: string, lines: ReadonlyArray<string>): string {
  return body.replace(originalBlock, `---\n${lines.join("\n")}\n---\n`);
}

function syntheticProvenance(boundAt: string, session: CurrentSessionRef): ProvenanceBackfillReport["provenance"] {
  const collisionSuffix = stablePayloadHash({
    runtime: session.runtime,
    sessionId: session.sessionId,
    boundAt
  }).slice(0, 8);
  const provenance = {
    runtime: session.runtime,
    sessionId: `${session.runtime}-provenance-backfill-${Date.parse(boundAt)}-${collisionSuffix}`,
    boundAt
  } as const;
  Schema.decodeUnknownSync(ProvenanceEntrySchema)(provenance);
  return provenance;
}
