import path from "node:path";
import { localRuntimeStateFileSystem as files } from "../local/local-layout-file-system.ts";
import { canonicalLedgerCut } from "./task-event-store-contract.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "./sqlite-event-store.ts";
import { readVerifiedLedgerBackup, drillLedgerBackup } from "./ledger-backup.ts";
import { planCompletionGeneration } from "./completion-generation-plan.ts";
import { writeCompletionGeneration, verifyCompletionGeneration } from "./completion-generation-target.ts";
import { publishGenerationThreeActivation } from "./generation-three-activation.ts";
import { readGenerationThreeActivation } from "./generation-three-selection.ts";
import { stableStringify } from "../integrity/stable-hash.ts";

export type CompletionActivationPoint = "verified" | "source-retired" | "derived-invalidated" | "published";

/** Operator-only entry; the caller owns the stopped repository's exclusive workspace lock. */
export function runCompletionGenerationConversion(input: {
  readonly backupDir: string;
  readonly mode: "dry-run" | "convert" | "verify" | "activate";
  readonly destinationRoot?: string;
  readonly approvedSnapshotGaps?: ReadonlySet<string>;
  readonly invalidateDerivedState: (repoId: string, root: string) => void;
  readonly checkpoint?: (point: CompletionActivationPoint) => void;
}) {
  const backupDir = path.resolve(input.backupDir),
    manifest = readVerifiedLedgerBackup(backupDir),
    generation = manifest.sqlite.generation;
  if (generation !== 1 && generation !== 2)
    throw new Error("completion conversion requires a generation 1 or 2 backup");
  const backupSource = openSqliteEventStore({ rootInput: path.join(backupDir, "payload"), generation, readOnly: true });
  const metadata = backupSource.metadata(),
    sourceCut = {
      ...canonicalLedgerCut(metadata.repoId, backupSource.eventIdentityAtRevision(metadata.revision)),
      generation: generation as 1 | 2,
    };
  try {
    if (input.mode === "dry-run") {
      const preview = planCompletionGeneration(backupSource, input.approvedSnapshotGaps ?? new Set());
      for (const _entry of preview.entries()) {
        /* conversion must finish before reporting ready */
      }
      return { plan: { ready: true, sourceCut, destinationGeneration: 3 }, active: false };
    }
  } finally {
    backupSource.close();
  }
  if (!input.destinationRoot || !path.isAbsolute(input.destinationRoot))
    throw new Error("conversion requires an absolute destination");
  const root = path.resolve(input.destinationRoot),
    relative = path.relative(backupDir, root);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".."))
    throw new Error("destination must be outside immutable backup");
  if (input.mode === "convert")
    drillLedgerBackup({
      backupDir,
      destinationRoot: root,
      shadowParent: path.dirname(root),
      verifiedManifest: manifest,
    });
  const sourceGeneration = generation;
  const originalSourcePath = sqliteLedgerPath(root, sourceGeneration),
    retiredRoot = path.join(root, ".harness", "store", "retired"),
    retiredSourcePath = path.join(retiredRoot, String(sourceGeneration), "ledger.sqlite");
  // An interrupted offline retirement resumes from its retained source, never an online fallback.
  const source = openSqliteEventStore({
    databasePath: files.exists(originalSourcePath) ? originalSourcePath : retiredSourcePath,
    generation: sourceGeneration,
    readOnly: true,
  });
  let verification, plan, acceptedCut;
  try {
    plan = planCompletionGeneration(source, input.approvedSnapshotGaps ?? new Set());
    if (input.mode === "convert") writeCompletionGeneration(source, root, plan);
    verification = verifyCompletionGeneration(source, root, plan);
    const target = openSqliteEventStore({ rootInput: root, generation: 3, readOnly: true });
    try {
      acceptedCut = canonicalLedgerCut(metadata.repoId, target.eventIdentityAtRevision(target.revision()));
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
  const report = { plan: { ready: true, sourceCut, destinationGeneration: 3 }, destinationRoot: root, verification };
  if (input.mode !== "activate") return { ...report, active: false };
  const certificate = {
    schema: "generation-activation/v3" as const,
    repoId: metadata.repoId,
    generation: 3 as const,
    sourceCut,
    importedPrefixRevision: sourceCut.revision,
    acceptedCut,
  };
  const existing = readGenerationThreeActivation({ rootInput: root, repoId: metadata.repoId });
  if (existing) {
    if (stableStringify(existing) !== stableStringify(certificate))
      throw new Error("generation 3 activation certificate differs");
    // A prior publisher may have stopped between link and directory fsync.
    files.syncDirectory(path.dirname(sqliteLedgerPath(root, 3)));
    return { ...report, active: true };
  }
  input.checkpoint?.("verified");
  // This comparison detects accepted writes between the backup and the offline window.
  // The original write boundary cannot know that the operator's backup has since become stale.
  const liveSourcePath = sqliteLedgerPath(root, generation);
  if (files.exists(liveSourcePath)) {
    const live = openSqliteEventStore({ databasePath: liveSourcePath, generation, readOnly: true });
    try {
      const actual = canonicalLedgerCut(metadata.repoId, live.eventIdentityAtRevision(live.revision()));
      if (actual.revision !== sourceCut.revision || actual.headDigest !== sourceCut.headDigest)
        throw new Error("offline source head changed after backup");
    } finally {
      live.close();
    }
  }
  for (const oldGeneration of [1, 2]) {
    const oldDirectory = path.dirname(sqliteLedgerPath(root, oldGeneration)),
      retired = path.join(retiredRoot, String(oldGeneration));
    files.mkdirp(retired);
    // Activation/import certificates stay at their original names, fencing old builds.
    for (const name of ["ledger.sqlite", "ledger.sqlite-wal", "ledger.sqlite-shm", "objects"]) {
      const oldPath = path.join(oldDirectory, name);
      if (files.exists(oldPath)) files.rename(oldPath, path.join(retired, name));
    }
    if (files.exists(oldDirectory)) files.syncDirectory(oldDirectory);
    files.syncDirectory(retired);
  }
  input.checkpoint?.("source-retired");
  for (const suffix of ["", "-wal", "-shm"]) files.remove(path.join(root, ".harness", "cache", `task.sqlite${suffix}`));
  input.invalidateDerivedState(metadata.repoId, root);
  input.checkpoint?.("derived-invalidated");
  publishGenerationThreeActivation(root, certificate);
  input.checkpoint?.("published");
  return { ...report, active: true };
}
