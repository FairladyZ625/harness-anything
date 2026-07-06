import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import type { HarnessLayoutInput } from "../../../kernel/src/index.ts";
import { resolveHarnessLayout } from "../../../kernel/src/index.ts";
import { LegacyCollisionReportSchema, type LegacyCollisionReport, type LegacyIndexEntry } from "../../../kernel/src/index.ts";

export interface LegacyCopyTarget {
  readonly entry: LegacyIndexEntry;
  readonly sourcePath: string;
  readonly chosenPath: string;
}

export interface LegacyCopyPlan {
  readonly targets: ReadonlyArray<LegacyCopyTarget>;
  readonly collisionReport: LegacyCollisionReport;
}

interface OccupiedTarget {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export function buildLegacyCopyPlan(rootDir: string, sourceRoot: string, entries: ReadonlyArray<LegacyIndexEntry>): LegacyCopyPlan {
  const occupied: OccupiedTarget[] = [];
  const collisionEntries: Array<LegacyCollisionReport["entries"][number]> = [];
  const targets = [...entries].sort(compareDeepestTargetFirst).map((entry) => {
    const sourcePath = path.resolve(rootDir, sourceRoot, entry.sourcePath);
    const kind = statSync(sourcePath).isDirectory() ? "directory" as const : "file" as const;
    const resolved = resolveTarget(rootDir, entry.storedPath, kind, occupied);
    occupied.push({ path: resolved.chosenPath, kind });
    if (resolved.suffixIndex !== null) {
      collisionEntries.push({
        kind,
        sourcePath: entry.sourcePath,
        targetPath: entry.storedPath,
        chosenPath: resolved.chosenPath,
        suffixIndex: resolved.suffixIndex,
        reason: "target-exists"
      });
    }
    return { entry, sourcePath, chosenPath: resolved.chosenPath };
  });
  return {
    targets,
    collisionReport: validateCollisionReport({
      schema: "legacy-collision-report/v1",
      legacyRoot: "harness/legacy",
      generatedAt: new Date(0).toISOString(),
      policy: {
        overwriteAllowed: false,
        directorySuffixPattern: "-legacy-import-N",
        fileSuffixPattern: ".legacy-import-N"
      },
      entries: collisionEntries
    })
  };
}

export function writeCollisionReport(rootInput: HarnessLayoutInput, report: LegacyCollisionReport): void {
  const layout = resolveHarnessLayout(rootInput);
  const validated = validateCollisionReport(report);
  mkdirSync(path.dirname(layout.legacyCollisionReportPath), { recursive: true });
  writeFileSync(layout.legacyCollisionReportPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

export function readCollisionReport(rootInput: HarnessLayoutInput): LegacyCollisionReport | null {
  const layout = resolveHarnessLayout(rootInput);
  if (!existsSync(layout.legacyCollisionReportPath)) return null;
  return validateCollisionReport(JSON.parse(readFileSync(layout.legacyCollisionReportPath, "utf8")));
}

export function applyCollisionReport(entries: ReadonlyArray<LegacyIndexEntry>, report: LegacyCollisionReport | null): ReadonlyArray<LegacyIndexEntry> {
  if (!report) return entries;
  const chosenByTarget = new Map(report.entries.map((entry) => [`${entry.sourcePath}\0${entry.targetPath}`, entry.chosenPath]));
  return entries.map((entry) => {
    const chosenPath = chosenByTarget.get(`${entry.sourcePath}\0${entry.storedPath}`);
    return chosenPath ? { ...entry, storedPath: chosenPath } : entry;
  });
}

function validateCollisionReport(report: unknown): LegacyCollisionReport {
  return Schema.decodeUnknownSync(LegacyCollisionReportSchema)(report);
}

function resolveTarget(rootDir: string, targetPath: string, kind: "file" | "directory", occupied: ReadonlyArray<OccupiedTarget>): { readonly chosenPath: string; readonly suffixIndex: number | null } {
  if (!targetUnavailable(rootDir, targetPath, occupied)) return { chosenPath: targetPath, suffixIndex: null };
  for (let suffixIndex = 1; suffixIndex < 10000; suffixIndex += 1) {
    const candidate = kind === "directory" ? directoryCollisionPath(targetPath, suffixIndex) : fileCollisionPath(targetPath, suffixIndex);
    if (!targetUnavailable(rootDir, candidate, occupied)) return { chosenPath: candidate, suffixIndex };
  }
  throw new Error(`unable to choose legacy collision target for ${targetPath}`);
}

function targetUnavailable(rootDir: string, targetPath: string, occupied: ReadonlyArray<OccupiedTarget>): boolean {
  return existsSync(path.join(rootDir, targetPath)) || occupied.some((entry) => targetsOverlap(entry, targetPath));
}

function targetsOverlap(entry: OccupiedTarget, targetPath: string): boolean {
  if (entry.path === targetPath) return true;
  if (entry.kind === "directory" && isDescendant(targetPath, entry.path)) return true;
  return isDescendant(entry.path, targetPath);
}

function isDescendant(candidate: string, ancestor: string): boolean {
  return candidate.startsWith(`${ancestor}/`);
}

function compareDeepestTargetFirst(left: LegacyIndexEntry, right: LegacyIndexEntry): number {
  return pathDepth(right.storedPath) - pathDepth(left.storedPath) || left.storedPath.localeCompare(right.storedPath);
}

function pathDepth(value: string): number {
  return value.split("/").length;
}

function directoryCollisionPath(targetPath: string, suffixIndex: number): string {
  return `${targetPath}-legacy-import-${suffixIndex}`;
}

function fileCollisionPath(targetPath: string, suffixIndex: number): string {
  const directory = path.posix.dirname(targetPath);
  const basename = path.posix.basename(targetPath);
  const extension = path.posix.extname(basename);
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  const suffixed = `${stem}.legacy-import-${suffixIndex}${extension}`;
  return directory === "." ? suffixed : `${directory}/${suffixed}`;
}
