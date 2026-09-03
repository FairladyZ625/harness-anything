import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  normalizeRelativeDocumentPath,
  parseSquadDeclarationV1,
  resolveHarnessLayout,
  stableStringify,
  type SquadDeclarationV1,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

// One-time cutover for direct-authored Squad declarations. Delete this command after the canonical
// migration is recorded; normal Squad reads and writes remain on the entity action/projection path.
interface SquadMigrationCandidate {
  readonly source: string;
  readonly target: string;
  readonly declaration: SquadDeclarationV1;
  readonly currentRevision: number;
  readonly change: "install" | "replace" | "already-installed";
}

interface SquadMigrationReport {
  readonly schema: "squad-entity-migration-report/v1";
  readonly mode: "dry-run" | "apply";
  readonly packageShape: {
    readonly manifest: "squad.json";
    readonly schema: "squad-declaration/v1";
  };
  readonly summary: {
    readonly requested: number;
    readonly installs: number;
    readonly replacements: number;
    readonly alreadyInstalled: number;
  };
  readonly squads: readonly {
    readonly source: string;
    readonly entityId: string;
    readonly target: string;
    readonly result: "would-install" | "would-replace" | "installed" | "replaced" | "already-installed";
  }[];
}

export async function runSquadEntityMigration(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): Promise<WriteReceipt> {
  const candidates = readCandidates(cell, action.sourcePaths);
  for (const candidate of candidates)
    await cell.entityActionExecutor.run(
      installAction(candidate, true),
      binding,
      childOperationId(cell, candidate, binding, true),
      cell.entityActionRuntimes,
    );

  if (action.dryRun === true) return previewReceipt(cell, action, binding, reportFor(candidates, true));

  let marker: WriteReceipt | null = null;
  for (const candidate of candidates) {
    if (candidate.change === "already-installed") continue;
    marker = await cell.entityActionExecutor.run(
      installAction(candidate, false),
      binding,
      childOperationId(cell, candidate, binding, false),
      cell.entityActionRuntimes,
    );
    if (marker.outcome !== "applied")
      migrationError(
        "squad_migration_incomplete",
        `Squad ${candidate.declaration.id} did not become visible at the canonical projection cut.`,
      );
  }
  return appliedReceipt(cell, action, binding, reportFor(candidates, false), marker);
}

function readCandidates(cell: RepoCellOperationalContext, value: unknown): readonly SquadMigrationCandidate[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim()))
    migrationError("invalid_command", "sourcePaths must contain one or more repository-relative legacy Squad files.");
  const sources = value.map((source) => portableSource(source as string));
  if (new Set(sources).size !== sources.length)
    migrationError("squad_migration_reconciliation_failed", "Legacy Squad sources must be unique.");

  const candidates = sources.map((source) => readCandidate(cell, source));
  const ids = candidates.map(({ declaration }) => declaration.id);
  if (new Set(ids).size !== ids.length)
    migrationError(
      "squad_migration_reconciliation_failed",
      `Legacy Squad sources contain duplicate entity ids: ${duplicates(ids).join(", ")}.`,
    );
  return candidates;
}

function readCandidate(cell: RepoCellOperationalContext, source: string): SquadMigrationCandidate {
  const sourcePath = path.join(cell.rootDir, ...source.split("/"));
  if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile() || lstatSync(sourcePath).isSymbolicLink())
    migrationError("invalid_package", `Legacy Squad source ${source} is not a regular file.`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    consumeKnownError(error);
    migrationError("invalid_manifest", `Legacy Squad source ${source} is not valid JSON.`);
  }
  let declaration: SquadDeclarationV1;
  try {
    declaration = parseSquadDeclarationV1(value);
  } catch (error) {
    consumeKnownError(error);
    migrationError(
      "invalid_manifest",
      `Legacy Squad source ${source} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const targetPath = path.join(resolveHarnessLayout(cell.rootDir).authoredRoot, "squads", `${declaration.id}.json`),
    target = normalizeRelativeDocumentPath(path.relative(cell.rootDir, targetPath).split(path.sep).join("/"));
  if (path.resolve(sourcePath) !== path.resolve(targetPath))
    migrationError(
      "squad_migration_reconciliation_failed",
      `Legacy Squad ${declaration.id} must be read from its canonical projection path ${target}; received ${source}.`,
    );
  const current = cell.projection.getEntity("squad", declaration.id),
    change =
      current === null
        ? "install"
        : stableStringify(current.value) === stableStringify(declaration)
          ? "already-installed"
          : "replace";
  return {
    source,
    target,
    declaration,
    currentRevision: current?.workspaceRevision ?? 0,
    change,
  };
}

function portableSource(value: string): string {
  try {
    return normalizeRelativeDocumentPath(value);
  } catch (error) {
    consumeKnownError(error);
    migrationError(
      "invalid_command",
      `Legacy Squad source must be a portable repository-relative path: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function installAction(candidate: SquadMigrationCandidate, dryRun: boolean): RepoTaskAction {
  return {
    kind: "squad-install",
    declaration: candidate.declaration,
    declarationSource: candidate.source,
    expectedVersion: candidate.currentRevision,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

function childOperationId(
  cell: RepoCellOperationalContext,
  candidate: SquadMigrationCandidate,
  binding: RepoCellBinding,
  dryRun: boolean,
): string {
  return cell.operationId(installAction(candidate, dryRun), binding, cell.input.repoId, candidate.currentRevision);
}

function reportFor(candidates: readonly SquadMigrationCandidate[], dryRun: boolean): SquadMigrationReport {
  return {
    schema: "squad-entity-migration-report/v1",
    mode: dryRun ? "dry-run" : "apply",
    packageShape: { manifest: "squad.json", schema: "squad-declaration/v1" },
    summary: {
      requested: candidates.length,
      installs: candidates.filter(({ change }) => change === "install").length,
      replacements: candidates.filter(({ change }) => change === "replace").length,
      alreadyInstalled: candidates.filter(({ change }) => change === "already-installed").length,
    },
    squads: candidates.map(({ source, target, declaration, change }) => ({
      source,
      entityId: declaration.id,
      target,
      result:
        change === "already-installed"
          ? change
          : dryRun
            ? change === "install"
              ? "would-install"
              : "would-replace"
            : change === "install"
              ? "installed"
              : "replaced",
    })),
  };
}

function previewReceipt(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  report: SquadMigrationReport,
): WriteReceipt {
  const revision = cell.store.readHead()?.revision ?? 0,
    opId = cell.operationId({ ...action, dryRun: false }, binding, cell.input.repoId, revision);
  return {
    outcome: "pending",
    opId: `preview:${opId}`,
    revision,
    evidence: JSON.stringify(report),
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: revision,
      durable: false,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    authorizationDecision: binding.authorizationDecision,
    nextAction: "Remove --dry-run to install every listed Squad through the canonical entity event stream.",
  };
}

function appliedReceipt(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
  report: SquadMigrationReport,
  marker: WriteReceipt | null,
): WriteReceipt {
  const revision = marker?.revision ?? cell.store.readHead()?.revision ?? 0;
  return {
    outcome: "applied",
    opId: marker?.opId ?? cell.operationId(action, binding, cell.input.repoId, revision),
    revision,
    evidence: JSON.stringify(report),
    visibility: "center",
    proof: marker?.proof ?? {
      committedRevision: revision,
      appliedCut: revision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: true,
    },
    authorizationDecision: binding.authorizationDecision,
  };
}

function duplicates(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
}

function migrationError(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
