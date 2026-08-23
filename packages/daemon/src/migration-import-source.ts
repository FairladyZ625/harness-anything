import { realpathSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, sha256Text } from "../../kernel/src/index.ts";
import { migrationImportError } from "./migration-import-report.ts";
import type {
  AuthoredCoverage,
  IdRemapping,
  ImportCounts,
  MigrationImportReceipt,
  SourceGitIdentity,
} from "./migration-import-types.ts";
import { runProcessText } from "./process-port.ts";
import type { RepoTaskAction } from "./repo-cell.ts";

export function migrationSourceRoots(action: RepoTaskAction): readonly string[] {
  if (
    !Array.isArray(action.sourceRoots) ||
    action.sourceRoots.length === 0 ||
    !action.sourceRoots.every((value) => typeof value === "string" && value.trim())
  )
    throw migrationImportError(
      "invalid_command",
      "migrate import requires one or more repeated --source <git-repository-path> values.",
    );
  const roots = action.sourceRoots as readonly string[];
  if (new Set(roots.map((value) => path.resolve(value))).size !== roots.length)
    throw migrationImportError(
      "invalid_command",
      "Each --source must name a different Git repository; remove duplicate source paths and retry.",
    );
  return roots;
}

export function migrationOperationId(sourceKey: string, kind: string, migratedFrom: string): string {
  return `migration-${sha256Text(`${sourceKey}\0${kind}\0${migratedFrom}`).slice(0, 26)}`;
}

export function validateSourceGit(sourceRoot: string, authoredRoot: string): SourceGitIdentity {
  const git = (...args: readonly string[]): string => {
    try {
      return runProcessText("git", ["-C", authoredRoot, ...args]).trim();
    } catch (error) {
      consumeKnownError(error);
      throw migrationImportError(
        "invalid_migration_source_git",
        [
          "Source ",
          `${sourceRoot}`,
          ' failed authored Git validation at "git ',
          `${args.join(" ")}`,
          '". Import only a complete, clean Git repository containing ',
          `${authoredRoot}`,
          "; repair or reclone the source, then retry.",
        ].join(""),
      );
    }
  };
  const top = realpathSync.native(git("rev-parse", "--show-toplevel"));
  if (top !== sourceRoot && top !== authoredRoot)
    throw migrationImportError(
      "invalid_migration_source_git",
      [
        "Source ",
        `${sourceRoot}`,
        " resolves authored data at ",
        `${authoredRoot}`,
        ", but Git reports unrelated root ",
        `${top}`,
        ". --source must own the authored tree directly or through its canonical ",
        "harness Git worktree.",
      ].join(""),
    );
  if (git("rev-parse", "--is-shallow-repository") === "true")
    throw migrationImportError(
      "invalid_migration_source_git",
      [
        "Source ",
        `${sourceRoot}`,
        " is backed by a shallow authored Git repository. Fetch complete history ",
        "before import so the source lineage and root commit can be verified.",
      ].join(""),
    );
  const dirty = git("status", "--porcelain=v1", "--untracked-files=all");
  if (dirty)
    throw migrationImportError(
      "invalid_migration_source_git",
      [
        "Source ",
        `${sourceRoot}`,
        " is not the committed authored Git snapshot being imported (",
        `${dirty.split("\n").slice(0, 3).join(", ")}`,
        "). Commit or discard every tracked and untracked authored change, then ",
        "rerun.",
      ].join(""),
    );
  git("fsck", "--full", "--no-dangling");
  const head = git("rev-parse", "--verify", "HEAD^{commit}"),
    tree = git("rev-parse", "--verify", "HEAD^{tree}"),
    roots = git("rev-list", "--max-parents=0", "HEAD").split(/\s+/u).filter(Boolean);
  if (roots.length !== 1)
    throw migrationImportError(
      "invalid_migration_source_git",
      [
        "Source ",
        `${sourceRoot}`,
        " has ",
        `${roots.length}`,
        " authored Git root commits. Import requires one complete lineage; split ",
        "unrelated histories into separate --source repositories.",
      ].join(""),
    );
  return { sourceId: roots[0]!, rootCommit: roots[0]!, head, tree };
}

export function idRemapConflict(kind: IdRemapping["entityType"], sourceId: string, targetId: string): Error {
  return migrationImportError(
    "migration_id_remap_conflict",
    [
      "ID collision: ",
      `${kind}`,
      " ",
      `${sourceId}`,
      " already exists in the destination, so importing a different Git source ",
      "triggers deterministic remapping to ",
      `${targetId}`,
      "; that remapped id is also occupied. Rename the source id or clear the ",
      "unrelated destination collision, then rerun the same --source.",
    ].join(""),
  );
}

export function combineMigrationReceipts(
  receipts: readonly MigrationImportReceipt[],
  requestedSources: readonly string[],
): MigrationImportReceipt {
  const last = receipts.at(-1);
  if (!last) throw migrationImportError("invalid_command", "migrate import requires at least one --source.");
  const sum = (select: (receipt: MigrationImportReceipt) => ImportCounts): ImportCounts =>
      Object.fromEntries(
        (["task", "decision", "fact", "relation", "coverage"] as const).map((kind) => [
          kind,
          receipts.reduce((total, receipt) => total + select(receipt)[kind], 0),
        ]),
      ) as unknown as ImportCounts,
    counts = {
      old: sum((receipt) => receipt.counts.old),
      skipped: sum((receipt) => receipt.counts.skipped),
      expected: sum((receipt) => receipt.counts.expected),
      new: sum((receipt) => receipt.counts.new),
    },
    authoredCoverage = combineAuthoredCoverage(receipts.map(({ authoredCoverage: coverage }) => coverage)),
    exitCode: 0 | 1 | 3 = receipts.some((receipt) => receipt.exitCode === 1)
      ? 1
      : receipts.some((receipt) => receipt.exitCode === 3)
        ? 3
        : 0,
    processed = receipts.length;
  return {
    outcome: exitCode === 1 ? "op_rejected" : "applied",
    opId: last.opId,
    revision: last.revision,
    evidence: JSON.stringify({
      sources: receipts.map((receipt) => JSON.parse(String(receipt.evidence))),
      requestedSources,
      processed,
    }),
    visibility: "center",
    proof: last.proof,
    summary: [
      `Migration import batch (${processed}/${requestedSources.length} sources processed)`,
      ...receipts.flatMap((receipt, index) => [
        "",
        `## Source ${index + 1}: ${requestedSources[index]}`,
        receipt.summary,
      ]),
    ].join("\n"),
    mode: last.mode,
    exitCode,
    counts,
    authoredCoverage,
    skippedEntities: receipts.flatMap(({ skippedEntities }) => skippedEntities),
    idMapPath: last.idMapPath,
    ...(exitCode === 1
      ? {
          code: "migration_reconciliation_failed",
          origin: "migration-import",
          nextAction: [
            "Source ",
            `${processed}`,
            " failed before the remaining sources ran. Repair the reported source or ",
            "resolution and rerun the same ordered --source list; completed source ",
            "imports are incremental no-ops.",
          ].join(""),
        }
      : {
          nextAction:
            exitCode === 3
              ? "Review all listed skips, repair the source Git snapshots, and rerun the same ordered --source list."
              : "All Git sources reconciled; the ordered batch may be rerun safely.",
        }),
  };
}

export function combineAuthoredCoverage(values: readonly AuthoredCoverage[]): AuthoredCoverage {
  return {
    passed: values.every(({ passed }) => passed),
    counts: {
      migrated: values.reduce((sum, value) => sum + value.counts.migrated, 0),
      excluded: values.reduce((sum, value) => sum + value.counts.excluded, 0),
      required: values.reduce((sum, value) => sum + value.counts.required, 0),
    },
    rows: values.flatMap(({ rows }) => rows),
  };
}

export function includeSourceEventCoverage(coverage: AuthoredCoverage, eventCount: number): AuthoredCoverage {
  if (eventCount === 0) return coverage;
  return {
    ...coverage,
    counts: {
      ...coverage.counts,
      excluded: coverage.counts.excluded + eventCount,
    },
    rows: [
      ...coverage.rows,
      {
        surface: "events/**",
        disposition: "excluded",
        old: eventCount,
        reason: [
          "canonical source events are consumed by semantic cold replay and ",
          "replaced by source-scoped migration events; raw event bytes remain in ",
          "the verified Git source",
        ].join(""),
        samples: [],
      },
    ],
  };
}
